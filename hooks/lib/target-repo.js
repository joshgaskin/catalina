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

/** Split into simple commands of words, quote-aware: [[word…]…]. Separators: && || ; | & newline. */
function simpleCommands(command) {
  const cmds = [];
  let words = [];
  let word = null; // null: between words
  const s = String(command);
  const end = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  const next = () => {
    end();
    if (words.length) cmds.push(words);
    words = [];
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
    } else if (c === "&" || c === "|" || c === ";" || c === "\n") {
      next();
      if ((c === "&" || c === "|") && s[i + 1] === c) i++;
    } else if (/\s/.test(c)) {
      end();
    } else if (c === "(" || c === ")" || ((c === "{" || c === "}") && word === null)) {
      next(); // a subshell, a group or a $(…) opens or closes a command
    } else {
      word = (word ?? "") + c;
    }
  }
  next();
  return cmds;
}

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const ALLOW = "CATALINA_WITNESS_ALLOW=1";

/** gh issue edit flags that take a value (so a number after them is not an issue). */
const VALUE_FLAGS = new Set([
  "-R", "--repo", "--add-label", "--remove-label", "--add-assignee", "--remove-assignee", "--add-project",
  "--remove-project", "-b", "--body", "-F", "--body-file", "-m", "--milestone", "-t", "--title",
]);

/** owner/name from a -R value (`owner/name` or `host/owner/name`). */
const slugOf = (v) => {
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

const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);

/**
 * Every review flip in a command: { numbers, repo, cds, allow, gitC }. cds are the `cd` arguments before it, in order
 * (unresolved); allow is the bypass as a prefix, through `env`, or from an earlier `export`; gitC lists `git -C` dirs.
 * A `bash -c '<script>'` is read as a child shell: it starts where its parent is and inherits the bypass.
 */
function parseFlips(command, ctx = { cds: [], gitC: [], exported: false }, depth = 0) {
  const flips = [];
  const { cds, gitC } = ctx;
  for (const cmd of simpleCommands(command)) {
    let i = 0;
    const assigns = [];
    while (i < cmd.length && ASSIGN.test(cmd[i])) assigns.push(cmd[i++]);
    let words = cmd.slice(i);
    if (words[0] === "env") {
      let j = 1;
      while (j < words.length && (ASSIGN.test(words[j]) || words[j].startsWith("-"))) assigns.push(words[j++]);
      words = words.slice(j);
    }
    const allow = assigns.includes(ALLOW) || (ctx.exported && !assigns.some((a) => a.startsWith("CATALINA_WITNESS_ALLOW=")));
    const head = words[0];
    if (head === "cd" || head === "pushd") {
      const arg = words.slice(1).find((w) => !w.startsWith("-"));
      cds.push(arg ?? "~");
    } else if (head === "export") {
      if (words.slice(1).includes(ALLOW)) ctx.exported = true;
      else if (words.slice(1).some((w) => w.startsWith("CATALINA_WITNESS_ALLOW="))) ctx.exported = false;
    } else if (head === "git") {
      for (let j = 1; j < words.length - 1; j++) if (words[j] === "-C") gitC.push(words[j + 1]);
    } else if (head === "gh") {
      const flip = readGh(words);
      if (flip) flips.push({ ...flip, cds: [...cds], allow, gitC: [...gitC] });
    } else if (SHELLS.has(path.basename(head || "")) && depth < 3) {
      const c = words.findIndex((w, j) => j > 0 && /^-[a-z]*c[a-z]*$/.test(w));
      if (c > 0 && words[c + 1] !== undefined) {
        flips.push(...parseFlips(words[c + 1], { cds: [...cds], gitC: [...gitC], exported: allow }, depth + 1));
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

/**
 * Where a flip's issues live: { dir } (a repo top level), or { dir: null, why } when it names a repo with no local
 * checkout here. `note` is set when a `git -C` in the command is a different repo than the one gated.
 */
function resolveFlip(flip, cwd, home = os.homedir()) {
  let here = cwd;
  for (const d of flip.cds) here = path.resolve(here, expand(d, home));
  const top = topLevel(here);
  let dir = top || here;
  if (flip.repo) {
    const base = top ? mainCheckout(top) : here;
    const name = flip.repo.split("/")[1];
    const candidates = [top, base, path.join(path.dirname(base), name), path.join(here, name)].filter(Boolean);
    dir = null;
    for (const c of candidates) {
      const t = topLevel(c);
      if (t && hasRemote(t, flip.repo)) {
        dir = t;
        break;
      }
    }
    if (!dir) return { dir: null, why: `no local checkout of ${flip.repo} found (looked at ${[...new Set(candidates)].join(", ")})` };
  }
  let note = null;
  for (const g of flip.gitC) {
    const other = topLevel(path.resolve(cwd, expand(g, home)));
    if (other && other !== dir) {
      note = `\`git -C ${g}\` doesn't change the repo gh edits: issue ${flip.numbers.join(", ") || "?"} is in ${dir} (git -C names ${other})`;
      break;
    }
  }
  return { dir, note };
}

module.exports = { parseFlips, resolveFlip, simpleCommands };
