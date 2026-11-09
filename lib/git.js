/**
 * Catalina — thin git helpers. Every call throws on failure; callers decide what a
 * failure means (the check fails closed, it never treats "git broke" as "nothing to check").
 */
const { execFileSync, spawnSync } = require("child_process");
const path = require("path");

const ZERO = /^0+$/;

function git(args, cwd, opts = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: opts.buffer ? null : "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function tryGit(args, cwd, opts) {
  try {
    return git(args, cwd, opts);
  } catch {
    return null;
  }
}

const out = (args, cwd) => git(args, cwd).trim();

function topLevel(cwd) {
  return out(["rev-parse", "--show-toplevel"], cwd);
}

function commonDir(cwd) {
  const d = out(["rev-parse", "--git-common-dir"], cwd);
  return path.isAbsolute(d) ? d : path.resolve(cwd, d);
}

/** "origin/main" style ref for the remote's default branch. */
function defaultRef(cwd, remote = "origin") {
  const sym = tryGit(["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`], cwd);
  if (sym && sym.trim()) return sym.trim();
  for (const b of ["main", "master"]) {
    if (tryGit(["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${b}`], cwd)) return `${remote}/${b}`;
  }
  throw new Error(`can't find ${remote}'s default branch (no ${remote}/HEAD, main or master)`);
}

/** File text at a commit, or null when the path doesn't exist there. */
function show(sha, rel, cwd) {
  const r = tryGit(["show", `${sha}:${rel}`], cwd);
  return r === null ? null : r;
}

function showBuffer(sha, rel, cwd) {
  return tryGit(["show", `${sha}:${rel}`], cwd, { buffer: true });
}

function blob(sha, rel, cwd) {
  const r = tryGit(["rev-parse", `${sha}:${rel}`], cwd);
  return r ? r.trim() : null;
}

function resolve(ref, cwd) {
  return out(["rev-parse", "--verify", `${ref}^{commit}`], cwd);
}

function isAncestor(a, b, cwd) {
  try {
    git(["merge-base", "--is-ancestor", a, b], cwd);
    return true;
  } catch {
    return false;
  }
}

function mergeBase(a, b, cwd) {
  return out(["merge-base", a, b], cwd);
}

/** Commits in base..tip, oldest first: [{sha, message, files}]. */
function commits(base, tip, cwd, extra = []) {
  const range = base ? [`${base}..${tip}`] : [tip];
  const raw = git(["log", "--reverse", "--format=%x1e%H%x1f%B%x1f", "--name-only", ...extra, ...range], cwd);
  return raw
    .split("\x1e")
    .filter((s) => s.trim())
    .map((rec) => {
      const [sha, message, files] = rec.split("\x1f");
      return {
        sha: sha.trim(),
        message: message.trim(),
        files: (files || "").split("\n").map((f) => f.trim()).filter(Boolean),
      };
    });
}

const NOT_TRACKING = [".", ":(exclude).claude/tracking"];

/** `git patch-id --stable` of the a..b diff of paths, or null when it is empty. */
function patchIdOf(a, b, paths, cwd) {
  const diff = git(["diff", "-U0", "--full-index", a, b, "--", ...paths], cwd);
  if (!diff.trim()) return null;
  return execFileSync("git", ["patch-id", "--stable"], { cwd, input: diff, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim().split(/\s+/)[0] || null;
}

/**
 * The patch-id of the a..b change outside .claude/tracking, or null when there is none. No context lines and no line
 * numbers, so the same change rebased over nearby or unrelated edits has the same id.
 */
function patchId(a, b, cwd) {
  return patchIdOf(a, b, NOT_TRACKING, cwd);
}

/** Files outside .claude/tracking whose a1..b1 change differs from their a2..b2 change (patch-id, as patchId). */
function differingFiles(a1, b1, a2, b2, cwd) {
  const names = (a, b) => out(["diff", "--name-only", a, b, "--", ...NOT_TRACKING], cwd).split("\n").filter(Boolean);
  return [...new Set([...names(a1, b1), ...names(a2, b2)])].sort().filter((f) => patchIdOf(a1, b1, [f], cwd) !== patchIdOf(a2, b2, [f], cwd));
}

/**
 * The tree git's three-way merge of `theirs` into `ours` produces (conflicted files hold their markers), or null when
 * git can't merge them. It is what applying `theirs`'s change onto `ours` gives with no hand edits.
 */
function mergeTree(ours, theirs, cwd) {
  const r = spawnSync("git", ["merge-tree", "--write-tree", ours, theirs], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const tree = String(r.stdout || "").split("\n")[0].trim();
  return r.status <= 1 && /^[0-9a-f]{40,64}$/.test(tree) ? tree : null;
}

/** Files outside .claude/tracking that differ between two trees or commits. */
function treeDiff(a, b, cwd) {
  return out(["diff", "--name-only", a, b, "--", ...NOT_TRACKING], cwd).split("\n").filter(Boolean);
}

/** Issue numbers a commit message references with Refs/Closes/Fixes/Resolves #N. */
function issueRefs(message) {
  const ns = new Set();
  for (const m of String(message).matchAll(/\b(?:refs?|close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi)) ns.add(Number(m[1]));
  return [...ns];
}

module.exports = {
  ZERO, git, tryGit, out, topLevel, commonDir, defaultRef, show, showBuffer, blob, resolve,
  isAncestor, mergeBase, commits, issueRefs, patchId, differingFiles, mergeTree, treeDiff, NOT_TRACKING,
};
